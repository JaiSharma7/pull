# Private study import

Studio's **Prepare study material** mode stores an extraction the reader has reviewed. Saving does not generate a course or call a model. Generation is a separately requested, budgeted job over versions the reader chooses; see [`study-generation.md`](./study-generation.md).

- Inputs: pasted text, TXT, Markdown, text PDF, DOCX, or existing imported highlights. A PNG, JPEG, WebP, or sparse PDF can use opt-in OCR. PDF and DOCX extraction and OCR run in the browser. The original file bytes are never uploaded.
- Limits: 12 MB per file, 30 PDF pages, five OCR pages per attempt, image OCR under 16 megapixels and 8,192 pixels per side, 200,000 characters per version, 100 live saved versions per account, and 1,000 lifetime saves per account. PDF page numbers remain in the saved text for later provenance. The reader can correct extraction errors before saving and must confirm sparse pages against the original.
- OCR loads first-party recognition code/data as needed, then processes the image locally. The preview tells the reader to verify OCR words, page order, and tables. OCR never silently overwrites edits in the preview.
- A save requires a signed-in non-guest account and rights confirmation. It appends a version through `save_study_source_version`, with a client mutation id so retrying after a lost response cannot duplicate it. The RPC serializes same-reader saves, validates limits again, and pins its search path.
- All three tables are owner-scoped under RLS. Readers can select their own rows and delete a whole source; they cannot change old version rows. Source deletion cascades its versions but keeps content-free retry markers. Account deletion cascades all three tables. Account export includes all three.
- Nothing in this import is made public or used to serve another reader. A later generation step must obtain separate permission and keep all provider calls budgeted and recorded.

The browser extraction is convenience, not proof that the text is complete. The saved version is exactly the text the reader reviewed. Later course generation must treat it as source evidence and retain provenance rather than assuming extraction or model output is correct.

A content-free mutation marker remains after a source is deleted so that retrying a lost save response cannot recreate the deleted text. The 1,000-save lifetime cap also bounds marker storage. This marker is included in account export and removed on account deletion. DOCX extraction verifies actual decompressed bytes in a timed worker before the document parser runs.

## Source URL and goal entry

A signed-in non-guest reader can preview an HTTPS HTML or plain-text page from one of three exact public hosts: en.wikisource.org, classics.mit.edu, or www.gutenberg.org. The server checks each redirect, rejects credentials and custom ports, stops at 1 MB or 20 seconds, and refuses unsupported content types or text over 200,000 characters. It does not store the URL response. Each attempt consumes one of 20 daily URL previews per account, even if extraction fails. The browser receives extracted text and the final URL; the reader checks and edits the text before the existing private save RPC stores a version. The extractor is deliberately simple and may include navigation or miss table structure.

Goal entry searches the existing public catalogue without a model call, then rechecks each candidate's `public_domain` status and source URL against the fixed preview allowlist. A suggestion is an attributed reading to inspect, not a legal guarantee or a generated course. If none qualify, the screen asks the reader to paste notes or upload a file. A selected source still requires extraction review and private-study rights confirmation. Imported text and derivatives never become public through this flow.
