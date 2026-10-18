# Format test corpus

Nineteen Nyanland-Meowtani files, one per format or edge case. Each holds known commitments (C10 to C32, continuing from the seed corpus) so a live run shows, per format, whether the file was scanned, skipped or failed, and which commitments it found. Ground truth is the `formats` section of `seed/answer_key.json`. `build.py` generates the files and that section from the same strings.

None of these files cancels, completes or reassigns C01 to C09, so the seed eval still holds with them in the folder. `npm run eval` reports them under `report.formats`, and they never fail it: their commitments are not counted as false positives, and the per-file and per-commitment results are observations to compare with the expected column below.

## How to run it

1. Upload the files to The Corporation one at a time, so each upload fires its own webhook. Leave this README and `build.py` out.
2. Watch the page, then run `npm run eval` for the full report.

"Today" means the code on `main` when this corpus was added: the supported extensions in `src/engine/cycle.ts` (txt, md, pdf, doc, docx, rtf, odt, html, htm, ppt, pptx, xls, xlsx), the 5 MB limit, and no OCR path.

| File | Format | Expected today | What it tests |
|---|---|---|---|
| 2026-10-14 Floor 3 Annexation Standup.docx | docx | Scanned; C10, C11 untracked | Smart quotes and an em dash in evidence |
| 2026-10-08 Memo - Stapler Consolidation Initiative.pdf | PDF with text | Scanned; C12 untracked | A table near the evidence sentence |
| Q4 World Domination Roadmap.pptx | pptx | Scanned; C13 untracked | C14 is only in speaker notes: found or not shows whether Box's text includes notes |
| Action Item Tracker - Floor 4 Annexation.xlsx | xlsx | Scanned; C15, C16 maybe unverified | Rows, not sentences. The cancelled row and the Ideas sheet must not become findings |
| 2026-10-13 東京支社 定例会議 議事録.docx | docx, Japanese | Scanned; C25 untracked, C26 and C27 untracked at low certainty | Katakana aliases; an unmapped owner (タマ支社長); a relative date (来週金曜日) |
| 2026-10-10 Contract - Laser Pointer Maintenance (with signed page).pdf | PDF, 2 text pages + 1 scanned | Scanned; C21 found, C20 not | A scanned page inside a text PDF |
| 2026-10-09 Decree - Mandatory Sunbeam Rotation (signed scan).pdf | PDF, image only | Scanned or an error (no text to extract); C17 not found | No text layer at all |
| FY26 Annual Report - Treat Reserves (scanned, 7 pages).pdf | PDF, image only, 7 pages | Scanned or an error; C18 and C19 not found | With an OCR path: Box AI's 5-page limit (C18 is on page 6) |
| Empty Agenda.txt | 0 bytes | Scanned; no findings, an error entry at most | No crash |
| Confidential - Succession Plan (password tuna).pdf | Encrypted PDF | Error on the page; cycle continues | Unreadable file |
| Whiteboard - Operation Lap Takeover.png | png | Skipped (type) | OCR candidate: shorthand "TUX", "Nov 7" |
| ホワイトボード - 世界征服会議.png | png, Japanese | Skipped (type) | OCR candidate: Japanese, Reiwa-era date (令和8年 = 2026) |
| Chat Screenshot - #exec-lounge.webp | webp | Skipped (type) | OCR candidate: "I" is the message author |
| Break Room Notice - Treat Dispenser.tiff | tiff | Skipped (type) | OCR candidate: recurring commitment, no due date |
| 2026-10-14 All-Paws Rehearsal - Transcript.vtt | vtt | Skipped (type) | Plain text; if `.vtt` is added, "I" is the speaker label |
| 2026-10-15 Board Meeting Recording.mp4 | mp4 | Skipped (type) | No AI call |
| Archive - Old Decrees.zip | zip | Skipped (type) | Not unpacked |
| MEMO_FROM_THE_CHAIRMEOW | Text, no extension | Skipped (type) | C32 would show if it were scanned |
| Floor Plan - Ultra High Resolution (oversize).pdf | PDF over 5 MB | Skipped (size) | C30 would show if the size check failed |

`config/people.yaml` already has the aliases these files need: タキシード, タキシード・ニャウタニ and TUX for Tuxedo; ピクセル for Pixel; ビスケッツ卿 for Sir Reginald Biscuits. タマ支社長 is left out on purpose.

## Regenerating

From the repo root: `python3 seed/formats/build.py`. It needs python-docx, python-pptx, openpyxl, reportlab, Pillow, qpdf, ffmpeg and the Noto Sans CJK font. It rewrites the files and the `formats` section of the answer key; the rest of the key is left untouched.
