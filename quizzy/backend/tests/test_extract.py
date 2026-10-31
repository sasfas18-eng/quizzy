import pytest

from app.services.extract import extract_file, parse_page_spec
from tests import fixtures


def test_pdf_pages_and_image_only_flagged(tmp_path):
    r = extract_file(fixtures.make_pdf(tmp_path / "a.pdf"), "pdf")
    assert [p.status for p in r.pages] == ["ok", "ok", "ok", "image_only"]
    assert "Cardiac output equals stroke volume" in r.pages[0].text
    assert "1. Isovolumetric contraction" in r.pages[1].text      # numbering preserved
    assert "120 mmHg" in r.pages[2].text and "5040 mL" in r.pages[0].text  # numbers/units preserved
    assert r.quality()["image_only"] == [4]


def test_arabic_pdf_logical_order(tmp_path):
    r = extract_file(fixtures.make_pdf(tmp_path / "ar.pdf", ar=True), "pdf")
    t = r.pages[0].text
    assert "الخلية هي الوحدة الأساسية للحياة" in t
    assert "الميتوكوندريا هي العضية المسؤولة" in t


def test_pptx_text_and_picture_only_slide(tmp_path):
    r = extract_file(fixtures.make_pptx(tmp_path / "a.pptx"), "pptx")
    assert r.pages[0].status == "ok" and "Cardiac Cycle Overview" in r.pages[0].text
    assert r.pages[2].status == "image_only" and r.pages[2].image_count == 1


def test_page_spec():
    assert parse_page_spec("1-3, 5", 10) == [1, 2, 3, 5]
    assert parse_page_spec(None, 3) == [1, 2, 3]
    with pytest.raises(ValueError):
        parse_page_spec("1-30", 10)
    with pytest.raises(ValueError):
        parse_page_spec("abc", 10)
