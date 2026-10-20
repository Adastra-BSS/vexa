# deploy/acr

Support files for the ACR build of this repo (see `acb.yaml` at the repo root). The build runs
inside the shared registry through `az acr run`; this directory only carries what its steps
execute.

Every run is given a **channel** (`az acr run --set channel=...`) that names what it publishes:

| Channel | Built from | Images | Chart |
|---|---|---|---|
| `jana-pilot` | the `attend-prod` branch, by `.github/workflows/build-attend-prod.yml` on every push | `vexa-<svc>:jana-pilot-<commit>` | `helm/vexa:<chart-version>-jana-pilot-<commit>` |
| `attend-dev-<id>` | a developer's own `attend-dev-<id>` branch, by Attend's `scripts/deploy_vexa_aks.sh` when that developer deploys their stack | `vexa-<svc>:attend-dev-<id>-<commit>` | `helm-dev/vexa:<chart-version>-attend-dev-<id>-<commit>` |

Prod and ci stacks deploy the newest chart in `helm/vexa`. Personal charts live in `helm-dev/vexa`,
so they never become that newest chart. Any other channel is refused before anything is built.

- `push-chart.sh` - packages `deploy/helm/charts/vexa` as `<chart-version>-<channel>-<commit>`
  and pushes it to `oci://<registry>/helm` (`jana-pilot`) or `oci://<registry>/helm-dev`
  (`attend-dev-*`), as the run's last step. A chart tag existing in the registry is the marker
  that every image of that commit has been pushed. It is a file rather than inline acb.yaml shell
  because ACB substitutes `$`-prefixed aliases in the task YAML, which mangles ordinary shell
  variables.
