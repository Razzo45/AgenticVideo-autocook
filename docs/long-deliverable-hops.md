# Long deliverables

One planned file per call stays. That keeps several SVGs out of one reply.

A Carbon unary `generateContent` is closed by the server at 10 minutes and holds at most 32,768 tokens of thinking plus output. A streamed hop is 20 minutes and 65,536 tokens. A drawing denser than one hop ends with a continuation token.

Stream that one file. When a hop ends with a continuation token, send the same request again with the token and append the new bytes. Repeat until the document is finished. Then `write_svg` runs once. The model is not asked to split the SVG across several `write_svg` calls. Those hops are the batches.

The same hop loop is the ceiling for the other text deliverables, such as HTML and the JSON that becomes a PDF or a deck. A picture, a video, or an audio file is produced by its own tool.

Do not raise the unary timer from 13 minutes to 20. That wait is already past the server close. The 20-minute budget is the streamed hop.

Today `brainGuidedWriteSvgThenJson` is unary. It sets no output cap, does not read the finish reason or a continuation token, and accepts a `write_svg` only when the whole argument parsed in one response. An unfinished argument is counted as an empty reply and stays on file 1 of the session.
