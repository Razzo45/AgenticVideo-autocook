"""Print the readable text of a PDF / DOCX / PPTX / XLSX to stdout (UTF-8). Tables become `a | b | c` rows."""
import sys
from pathlib import Path


def pdf_text(p: Path) -> str:
    import fitz

    return "\n".join(page.get_text() for page in fitz.open(str(p)))


def docx_text(p: Path) -> str:
    import docx

    out = []
    for child in docx.Document(str(p)).element.body.iterchildren():
        tag = child.tag.split("}")[-1]
        if tag == "p":
            t = "".join(r.text or "" for r in child.iter() if r.tag.endswith("}t")).strip()
            if t:
                out.append(t)
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


def pptx_text(p: Path) -> str:
    from pptx import Presentation

    out = []
    for i, slide in enumerate(Presentation(str(p)).slides, 1):
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


def xlsx_text(p: Path) -> str:
    import openpyxl

    wb = openpyxl.load_workbook(str(p), read_only=True, data_only=True)
    out = []
    for ws in wb.worksheets:
        out.append(f"--- Sheet: {ws.title} ---")
        for row in ws.iter_rows(values_only=True):
            cells = ["" if c is None else str(c).strip() for c in row]
            if any(cells):
                out.append(" | ".join(cells))
    return "\n".join(out)


def main() -> None:
    p = Path(sys.argv[1])
    ext = p.suffix.lower()
    text = {".pdf": pdf_text, ".docx": docx_text, ".pptx": pptx_text, ".xlsx": xlsx_text}[ext](p)
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdout.write(text)


if __name__ == "__main__":
    main()
