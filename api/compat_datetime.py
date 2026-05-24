"""Python 3.10 compat: datetime.UTC was added in 3.11."""
import datetime as _dt
import sys

if sys.version_info >= (3, 11):
    UTC = _dt.UTC
else:
    UTC = _dt.timezone.utc
