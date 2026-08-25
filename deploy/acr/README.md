# deploy/acr

Support files for the ACR task that builds this repo (see `acb.yaml` at the repo root). The
task is created on the consuming registry by the deployment repo; this directory only carries
what the task's steps execute.

- `push-chart.sh` - packages `deploy/helm/charts/vexa` as `<chart-version>-jana-pilot-<commit>`
  and pushes it to `oci://<registry>/helm`, as the run's last step. A chart tag existing in the
  registry is the marker that every image of that commit has been pushed. It is a file rather
  than inline acb.yaml shell because ACB substitutes `$`-prefixed aliases in the task YAML,
  which mangles ordinary shell variables.
