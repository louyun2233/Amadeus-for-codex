"""Give the Qt child window the launcher identity and icon on the Windows taskbar."""

import ctypes
import uuid
from ctypes import wintypes
from pathlib import Path


APP_ID = "Amadeus.for.Codex.Desktop"
_APP_KEY = uuid.UUID("9f4c2855-9f79-4b39-a8d0-e1d42de1d5f3")
_PROPERTY_STORE = uuid.UUID("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99")


class GUID(ctypes.Structure):
    _fields_ = [("data1", wintypes.DWORD), ("data2", wintypes.WORD),
                ("data3", wintypes.WORD), ("data4", ctypes.c_ubyte * 8)]

    @classmethod
    def from_uuid(cls, value):
        return cls.from_buffer_copy(value.bytes_le)


class PROPERTYKEY(ctypes.Structure):
    _fields_ = [("fmtid", GUID), ("pid", wintypes.DWORD)]


class STRING_PROPVARIANT(ctypes.Structure):
    _fields_ = [("vt", wintypes.WORD), ("reserved1", wintypes.WORD),
                ("reserved2", wintypes.WORD), ("reserved3", wintypes.WORD),
                ("value", ctypes.c_void_p)]


def _check(hr, operation):
    if hr < 0:
        raise OSError(f"{operation} failed: HRESULT 0x{hr & 0xffffffff:08x}")


def set_process_identity():
    function = ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID
    function.argtypes = [wintypes.LPCWSTR]
    function.restype = ctypes.c_long
    _check(function(APP_ID), "SetCurrentProcessExplicitAppUserModelID")


def set_window_identity(hwnd, root):
    """Set the taskbar's relaunch target/icon before attaching its AppUserModelID."""
    shell = ctypes.windll.shell32
    getter = shell.SHGetPropertyStoreForWindow
    getter.argtypes = [wintypes.HWND, ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p)]
    getter.restype = ctypes.c_long
    store = ctypes.c_void_p()
    iid = GUID.from_uuid(_PROPERTY_STORE)
    _check(getter(hwnd, ctypes.byref(iid), ctypes.byref(store)),
           "SHGetPropertyStoreForWindow")
    # IPropertyStore: IUnknown(0..2), GetCount(3), GetAt(4), GetValue(5),
    # SetValue(6), Commit(7).
    table = ctypes.cast(store, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    set_value = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p,
                                  ctypes.POINTER(PROPERTYKEY), ctypes.c_void_p)(table[6])
    commit = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p)(table[7])
    release = ctypes.WINFUNCTYPE(wintypes.ULONG, ctypes.c_void_p)(table[2])

    def put(pid, value):
        backing = ctypes.create_unicode_buffer(value)
        variant = STRING_PROPVARIANT(31, 0, 0, 0, ctypes.addressof(backing))
        key = PROPERTYKEY(GUID.from_uuid(_APP_KEY), pid)
        _check(set_value(store, ctypes.byref(key), ctypes.byref(variant)),
               f"IPropertyStore.SetValue({pid})")

    root = Path(root).resolve()
    launcher = root / "Amadeus.exe"
    icon = root / "scripts" / "Amadeus.ico"
    try:
        put(2, f'"{launcher}"')
        put(4, "Amadeus")
        put(3, f"{icon},0")
        put(5, APP_ID)
        _check(commit(store), "IPropertyStore.Commit")
    finally:
        release(store)
