"""The SHAPE of a spawned k8s Pod beyond its argv: /dev/shm, resource limits, and the patch strategy
that lets either of them exist at all.

Both are CONTAINER-level fields, so both have to travel in the `--overrides` containers list — the
very thing #673's comment forbade, because `kubectl run --overrides` defaults to `--override-type=merge`
(a JSON merge patch), which replaces the containers LIST wholesale: the generated image, env and
command vanish and the API server answers `spec.containers[0].image: Required value`. That failure was
witnessed live on v0.12.8 staging and is reproducible against any real API server.

`--override-type=strategic` is the fix. A strategic merge patch merges containers BY NAME
(patchMergeKey), so an entry carrying only `name` plus the fields we want AUGMENTS the generated
container instead of replacing it. Verified against a real API server (kind, k8s v1.36) with
`kubectl run --dry-run=server`: image, env and command all survive while volumeMounts, resources,
tolerations and nodeSelector all apply.

That also retroactively fixes the workspace-store mount seam, which emitted a containers entry under
the merge strategy and would have died the same way on any spawn that actually carried a PVC.
"""
from __future__ import annotations

import json

import runtime_kernel.k8s_backend as k8s_backend
from runtime_kernel.k8s_backend import K8sBackend, pod_overrides
from runtime_kernel.models import Resources
from runtime_kernel.profiles import Runnable


def _capture(monkeypatch) -> list:
    calls: list[list[str]] = []

    def fake_kubectl(*args, check=True):
        calls.append(list(args))

        class _R:
            returncode = 0
            stdout = ""
            stderr = ""

        return _R()

    monkeypatch.setattr(k8s_backend, "_kubectl", fake_kubectl)
    return calls


def _overrides_of(argv: list[str]) -> dict:
    return json.loads(argv[argv.index("--overrides") + 1])


# ─── the patch strategy ───────────────────────────────────────────────────────────────────────────

def test_spawn_uses_the_strategic_patch_strategy(monkeypatch):
    """Without this flag every override below is fatal rather than helpful: the default merge patch
    replaces the containers list, so the Pod loses its image and the API server rejects it."""
    calls = _capture(monkeypatch)
    K8sBackend(namespace="ns").start("mtg-1", Runnable(image="bot:test"), env={})
    assert "--override-type=strategic" in calls[0]


# ─── /dev/shm ─────────────────────────────────────────────────────────────────────────────────────

def test_pod_overrides_always_mount_a_memory_backed_dev_shm():
    """A k8s Pod's default /dev/shm is 64MB. Chromium needs far more and dies without it, which is
    exactly why the docker backend has always passed ShmSize (default 2g) — this is that parity.

    It is UNCONDITIONAL: a plain meeting bot carries no PVC and no scheduling constraints, and that
    is precisely the workload that needs the shm. Gating it on any other seam would give it to every
    workload except the browser."""
    ov = pod_overrides({}, container_name="vexa-mtg-1")
    assert ov is not None, "a spawn with no other seam must STILL get its /dev/shm"
    spec = ov["spec"]
    assert {"name": "dshm", "emptyDir": {"medium": "Memory", "sizeLimit": "2Gi"}} in spec["volumes"]
    (container,) = spec["containers"]
    assert container["name"] == "vexa-mtg-1"  # must match the generated container or nothing merges
    assert {"name": "dshm", "mountPath": "/dev/shm"} in container["volumeMounts"]


def test_dev_shm_size_is_tunable_like_the_docker_backends():
    """RUNTIME_K8S_SHM_SIZE is the k8s counterpart of DOCKER_SHM_SIZE."""
    ov = pod_overrides({"RUNTIME_K8S_SHM_SIZE": "512Mi"}, container_name="c")
    assert ov["spec"]["volumes"][0]["emptyDir"]["sizeLimit"] == "512Mi"


def test_dev_shm_coexists_with_the_workspace_store_mounts():
    """The shm mount is ADDED to the workspace mount set, never instead of it."""
    env = {
        "VEXA_WORKSPACE_MOUNT_SOURCE": "vexa-agent-workspaces",
        "VEXA_WORKSPACE_MOUNT_TARGET": "/workspaces",
        "VEXA_MOUNTS": json.dumps([{"slug": "u1", "path": "/workspaces/u1", "write": True}]),
    }
    (container,) = pod_overrides(env, container_name="w")["spec"]["containers"]
    paths = [m["mountPath"] for m in container["volumeMounts"]]
    assert "/dev/shm" in paths and "/workspaces/u1" in paths


# ─── resources ────────────────────────────────────────────────────────────────────────────────────

def test_pod_overrides_carry_requests_and_limits_from_the_spec():
    """WorkloadSpec.resources existed but reached no backend. On a bot pool that autoscales by
    schedulability, a Pod with no requests tells the autoscaler nothing — nodes never scale up, and
    bots pack until they OOM each other. Requests and limits are set to the SAME values so a bot is
    Guaranteed QoS and per-node packing is exactly what the pool was sized for."""
    ov = pod_overrides({}, container_name="c", resources=Resources(cpu=1.0, memoryMb=2560))
    (container,) = ov["spec"]["containers"]
    assert container["resources"] == {
        "requests": {"cpu": "1.0", "memory": "2560Mi"},
        "limits": {"cpu": "1.0", "memory": "2560Mi"},
    }


def test_partial_resources_emit_only_what_was_asked_for():
    """A spec that names only memory must not invent a cpu limit — an unrequested cpu limit would
    throttle the browser."""
    (container,) = pod_overrides({}, container_name="c",
                                 resources=Resources(memoryMb=2048))["spec"]["containers"]
    assert container["resources"] == {"requests": {"memory": "2048Mi"},
                                      "limits": {"memory": "2048Mi"}}


def test_no_resources_means_no_resources_key():
    (container,) = pod_overrides({}, container_name="c")["spec"]["containers"]
    assert "resources" not in container


def test_gpu_rides_the_limits_only():
    """The nvidia device plugin is a limits-only extended resource; a requests entry for it is
    invalid."""
    (container,) = pod_overrides({}, container_name="c",
                                 resources=Resources(gpu=1))["spec"]["containers"]
    assert container["resources"]["limits"]["nvidia.com/gpu"] == "1"
    assert "nvidia.com/gpu" not in container["resources"].get("requests", {})


def test_start_threads_the_specs_resources_into_the_override(monkeypatch):
    """The end-to-end seam: what create() was given reaches the Pod."""
    calls = _capture(monkeypatch)
    K8sBackend(namespace="ns").start("mtg-2", Runnable(image="bot:test"), env={},
                                     resources=Resources(cpu=1.0, memoryMb=2560))
    (container,) = _overrides_of(calls[0])["spec"]["containers"]
    assert container["resources"]["limits"]["memory"] == "2560Mi"


def test_scheduling_constraints_still_ride_the_same_override(monkeypatch):
    """#673's seam must survive the reshaping — tolerations and nodeSelector are POD-level and stay
    outside the containers entry."""
    calls = _capture(monkeypatch)
    monkeypatch.setenv("RUNTIME_K8S_TOLERATIONS",
                       json.dumps([{"key": "dedicated", "operator": "Equal",
                                    "value": "bots", "effect": "NoSchedule"}]))
    monkeypatch.setenv("RUNTIME_K8S_NODE_SELECTOR", json.dumps({"pool": "bots"}))
    K8sBackend(namespace="ns").start("mtg-3", Runnable(image="bot:test"), env={})
    spec = _overrides_of(calls[0])["spec"]
    assert spec["tolerations"][0]["value"] == "bots"
    assert spec["nodeSelector"] == {"pool": "bots"}
    assert "tolerations" not in spec["containers"][0]
