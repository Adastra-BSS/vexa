- **Azure Blob recordings without an account key (#4).** On helm, `AZURE_STORAGE_ACCOUNT_URL`
  (chart value `meetingApi.azureStorageAccountUrl`) reaches the recordings container with the pod's
  workload identity instead of a connection string, so the storage account can run with shared-key
  access disabled. The chart gains an optional meeting-api ServiceAccount and `meetingApi.podLabels`
  to wire the identity, and `TRANSCRIPTION_SERVICE_TOKEN` becomes optional for deployments with
  in-call transcription off. A deployment that sets the connection string is unchanged: it wins
  when both are set. See [Configuration](/configuration).
