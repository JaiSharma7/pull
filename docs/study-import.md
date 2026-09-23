# Private study import

Studio's **Prepare study material** mode stores an extraction the reader has reviewed. It does not generate a course or call a model. That work belongs to later, separately requested generation jobs.

- Inputs: pasted text, TXT, Markdown, text PDF, DOCX, or existing imported highlights. A PNG, JPEG, WebP, or sparse PDF can use opt-in OCR. PDF and DOCX extraction and OCR run in the browser. The original file bytes are never uploaded.
- Limits: 12 MB per file, 30 PDF pages, five OCR pages per attempt, 200,000 characters per version, and 100 saved versions per account. PDF page numbers remain in the saved text for later provenance. The reader can correct extraction errors before saving and must confirm sparse pages against the original.
- OCR downloads its recognition code/data as needed, then processes the image locally. The preview tells the reader to verify OCR words, page order, and tables. OCR never silently overwrites edits in the preview.
- A save requires a signed-in non-guest account and rights confirmation. It appends a version through `save_study_source_version`, with a client mutation id so retrying after a lost response cannot duplicate it. The RPC serializes same-reader saves, validates limits again, and pins its search path.
- Both tables are owner-scoped under RLS. Readers can select their own rows and delete a whole source; they cannot change old version rows. Source deletion cascades its versions. Account deletion cascades both tables. Account export includes both.
- Nothing in this import is made public or used to serve another reader. A later generation step must obtain separate permission and keep all provider calls budgeted and recorded.

The browser extraction is convenience, not proof that the text is complete. The saved version is exactly the text the reader reviewed. Later course generation must treat it as source evidence and retain provenance rather than assuming extraction or model output is correct.
