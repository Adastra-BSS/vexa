- **Recordings bucket creation now fails loudly instead of silently (#990).** Vexa Lite and Compose
  previously swallowed the result of creating the MinIO bucket, so a bucket that was never created —
  because MinIO was still starting, or the credentials were wrong — was reported as `✓ MinIO ready`
  and only surfaced much later as a failed recording upload. Both surfaces now wait for MinIO to be
  genuinely ready (up to 120s), verify the bucket exists, and abort the bring-up with the underlying
  error if it does not. Lite also re-checks the bucket on every `make up`, so an install left in the
  broken state repairs itself on the next run. See [Deployment](/deployment).
