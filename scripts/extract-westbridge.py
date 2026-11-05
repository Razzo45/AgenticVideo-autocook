from pathlib import Path

ROOT = Path("tasks/task-westbridge-access-card")
INP, PREP = ROOT / "inputs", ROOT / "prepared"

src = Path("scripts/extract-field-grove.py").read_text(encoding="utf8")
helpers = src.split("jobs = {")[0]
ns: dict = {}
exec(helpers, ns)


def pdf_text(p: Path) -> str:
    import fitz
    doc = fitz.open(str(p))
    return "\n".join(page.get_text() for page in doc)


jobs = {
    "creative-brief.txt": pdf_text(INP / "Westbridge_Health_Access_Card_Rollout_Brief.docx.pdf"),
    "script.txt": ns["docx_text"](INP / "Westbridge_Access_Card_Script.docx"),
    "brand-guidelines.txt": ns["pptx_text"](INP / "Westbridge_Health_Brand_Guidelines.pptx"),
}
for name, text in jobs.items():
    (PREP / name).write_text(text, encoding="utf8")
    print(f"{name}: {len(text)} chars")
