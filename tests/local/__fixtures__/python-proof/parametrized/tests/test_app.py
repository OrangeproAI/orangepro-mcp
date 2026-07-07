import pytest

from app import value


@pytest.mark.parametrize("expected", [3])
def test_value(expected):
    assert value() == expected

