from app import values


def test_has_three_values():
    assert len(values()) == 3
