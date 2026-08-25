#!/bin/sh
# Runs as the last acb.yaml step, inside alpine/helm: packages the chart versioned
# <chart-version>-jana-pilot-<commit> and pushes it as an OCI artifact. Lives as a file rather
# than inline in acb.yaml because ACB substitutes $-prefixed aliases in the task YAML, which
# mangles ordinary shell variables there.
set -e

REGISTRY=$1
COMMIT=$2
[ -n "$REGISTRY" ] && [ -n "$COMMIT" ] || { echo "usage: push-chart.sh <registry> <commit>" >&2; exit 1; }

# The task's registry credentials land in the shared docker config; helm reads the same file.
CONFIG="${DOCKER_CONFIG:-/root/.docker}/config.json"
if [ -f "$CONFIG" ]; then
    export HELM_REGISTRY_CONFIG="$CONFIG"
else
    echo "warning: no docker config at $CONFIG - helm push will rely on ambient auth" >&2
fi

VER=$(sed -n 's/^version: *//p' deploy/helm/charts/vexa/Chart.yaml)
[ -n "$VER" ] || { echo "could not read version from Chart.yaml" >&2; exit 1; }

helm package deploy/helm/charts/vexa --version "$VER-jana-pilot-$COMMIT" -d /tmp/chart
helm push "/tmp/chart/vexa-$VER-jana-pilot-$COMMIT.tgz" "oci://$REGISTRY/helm"
