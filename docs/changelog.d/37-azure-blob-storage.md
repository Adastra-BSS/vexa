- **Recordings can be stored in Azure Blob Storage (#37).** `STORAGE_BACKEND=azure` plus
  `AZURE_STORAGE_CONNECTION_STRING` writes recording chunks and masters to an Azure Blob container
  (`AZURE_STORAGE_CONTAINER`, default `vexa`) instead of the S3-compatible store, so a deployment no
  longer needs MinIO. The default stays `minio` and every existing key keeps its meaning — moving a
  deployment either way is an env change, not a new image. Available on compose, helm and lite.
  See [Deployment](/deployment).
