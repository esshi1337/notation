"""Operate only the GTK save dialog belonging to an isolated test profile."""
from pathlib import Path
import time


def save_file(output: Path, data_directory: Path, timeout: float = 30) -> None:
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for app in Atspi.get_desktop(0):
            if app.get_name() != 'notation':
                continue
            try:
                environment = Path(f'/proc/{app.get_process_id()}/environ').read_bytes().split(b'\0')
            except OSError:
                continue
            if b'XDG_DATA_HOME=' + bytes(data_directory) not in environment:
                continue
            for dialog in app:
                if dialog.get_role_name() != 'file chooser' or dialog.get_name() != 'Save File':
                    continue
                header = dialog.get_child_at_index(0)
                save = next((child for child in header if child.get_role_name() == 'button' and child.get_name() == 'Save'), None)
                fields = [field for child in header for field in child if field.get_role_name() == 'text']
                if save is None or len(fields) != 1:
                    raise AssertionError('Unexpected GTK save dialog structure; no input was sent.')
                if not fields[0].get_editable_text_iface().set_text_contents(str(output)):
                    raise AssertionError('Could not enter the isolated export destination.')
                if not save.get_action_iface().do_action(0):
                    raise AssertionError('Could not activate the GTK Save button.')
                return
        time.sleep(.15)
    raise AssertionError('The isolated application did not show its GTK save dialog.')
