import sys, zipfile, re
from pathlib import Path

ROOT = Path("tasks/task-field-grove-onboarding")
INP, PREP = ROOT / "inputs", ROOT / "prepared"


def docx_text(p: Path) -> str:
    try:
        import docx  # python-docx
        d = docx.Document(str(p))
        out = []
        body = d.element.body
        for child in body.iterchildren():
            tag = child.tag.split("}")[-1]
            if tag == "p":
                t = "".join(r.text or "" for r in child.iter() if r.tag.endswith("}t"))
                if t.strip():
                    out.append(t.strip())
            elif tag == "tbl":
                for row in child.iter():
                    if not row.tag.endswith("}tr"):
                        continue
                    cells = []
                    for tc in row:
                        if not tc.tag.endswith("}tc"):
                            continue
                        paras = []
                        for para in tc.iter():
                            if para.tag.endswith("}p"):
                                s = "".join(x.text or "" for x in para.iter() if x.tag.endswith("}t")).strip()
                                if s:
                                    paras.append(s)
                        cells.append(" / ".join(paras))
                    out.append(" | ".join(cells))
        return "\n".join(out)
    except ImportError:
        xml = zipfile.ZipFile(p).read("word/document.xml").decode("utf8")
        xml = re.sub(r"</w:p>", "\n", xml)
        xml = re.sub(r"</w:tc>", " | ", xml)
        return re.sub(r"<[^>]+>", "", xml)


def pptx_text(p: Path) -> str:
    from pptx import Presentation
    prs = Presentation(str(p))
    out = []
    for i, slide in enumerate(prs.slides, 1):
        out.append(f"--- Slide {i} ---")
        for shape in slide.shapes:
            if shape.has_text_frame:
                t = "\n".join(par.text for par in shape.text_frame.paragraphs if par.text.strip())
                if t.strip():
                    out.append(t.strip())
            if getattr(shape, "has_table", False) and shape.has_table:
                for row in shape.table.rows:
                    out.append(" | ".join(c.text.strip() for c in row.cells))
    return "\n".join(out)


jobs = {
    "creative-brief.txt": docx_text(INP / "Field_and_Grove_Markets_Creative_Brief_3_Page_REVISED.docx"),
    "av-script.txt": docx_text(INP / "Field_and_Grove_Markets_New_Employee_Onboarding_Script.docx"),
    "brand-guidelines.txt": pptx_text(INP / "Field & Grove Markets Brand Guidelines.pptx"),
}
for name, text in jobs.items():
    (PREP / name).write_text(text, encoding="utf8")
    print(f"{name}: {len(text)} chars")
