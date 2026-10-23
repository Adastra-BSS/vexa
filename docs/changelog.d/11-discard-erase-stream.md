- **A discarded meeting's transcript feed is erased again.** The erasure called `delete` on the
  segment stream bus, which has no such method, so every discard ended in
  `meeting_discard_erase_failed` after the recordings and transcripts were already gone, leaving the
  `tc:meeting:{id}` stream behind. The bus now has `delete_stream`, and the test runs against the
  bus production wires.
