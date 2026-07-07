from app import credited


def test_credited():
    assert isinstance(credited(), int)


def test_other():
    assert credited() == 5
