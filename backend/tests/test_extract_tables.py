"""The server edition reads ruled PDF tables and PPTX chart data as text (image OCR lives in the browser editions)."""
from app.services.extract import extract_pdf, extract_pptx
from tests import fixtures


def test_ruled_pdf_table_becomes_pipe_rows_in_place(tmp_path):
    res = extract_pdf(fixtures.make_grid_table_pdf(tmp_path / "grid.pdf"))
    t = res.pages[0].text
    assert "Drug | Dose | Route" in t and "Aspirin | 75 mg | Oral" in t and "Insulin | 10 units | Subcutaneous" in t
    lines = t.splitlines()
    assert lines[0].startswith("The table below") and lines[-1].startswith("Doses must be adjusted"), "text around the table keeps its place"


def test_pptx_chart_values_are_text_and_not_reported_as_unread(tmp_path):
    res = extract_pptx(fixtures.make_rich_pptx(tmp_path / "rich.pptx"))
    slide2 = res.pages[1].text
    assert "Cardiac output (L/min): Rest=5.0; Exercise=15.0; Sepsis=9.0" in slide2
    assert "Drug | Dose | Route" in res.pages[0].text and "Speaker" in res.pages[2].text
    assert not any("رسم بياني" in n for n in res.pages[1].notes)
