from pathlib import Path

ROOT = Path("tasks/task-haven-resident-portal")
INP, PREP = ROOT / "inputs", ROOT / "prepared"

src = Path("scripts/extract-field-grove.py").read_text(encoding="utf8")
ns: dict = {}
exec(src.split("jobs = {")[0], ns)


def pdf_text(p: Path) -> str:
    import fitz
    return "\n".join(page.get_text() for page in fitz.open(str(p)))


jobs = {
    "creative-brief.txt": pdf_text(INP / "Haven_Resident_Portal_Creative_Brief.docx.pdf"),
    "script.txt": ns["docx_text"](INP / "Haven_Property_Management_Resident_Portal_Script.docx"),
    "brand-guidelines.txt": ns["pptx_text"](INP / "Haven_Property_Management_Brand_Guidelines.pptx"),
}
for name, text in jobs.items():
    (PREP / name).write_text(text, encoding="utf8")
    print(f"{name}: {len(text)} chars")
