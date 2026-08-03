- **A scheduled meeting whose bot cannot spawn now says so on the meeting row (#989).** The auto-join
  sweep stamps `auto_join_error` for every way a spawn can refuse, including the transcription and
  authenticated-bot config gates and unexpected errors. Previously those escaped the sweep: the row
  stayed `scheduled` with no error anywhere, and every later due row in the same tick silently lost
  its bot. See [Configuration](/configuration).
