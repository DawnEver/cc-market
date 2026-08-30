from academia.cli import dispatch


class ReconfigurableStream:
    def __init__(self):
        self.encodings = []

    def reconfigure(self, *, encoding):
        self.encodings.append(encoding)


def test_cli_entry_point_configures_both_output_streams_as_utf8(monkeypatch):
    stdout = ReconfigurableStream()
    stderr = ReconfigurableStream()
    monkeypatch.setattr(dispatch.sys, "stdout", stdout)
    monkeypatch.setattr(dispatch.sys, "stderr", stderr)
    monkeypatch.setattr(dispatch, "_dispatch", lambda *args: 0)

    assert dispatch.rev_disc_main(["status"]) == 0

    assert stdout.encodings == ["utf-8"]
    assert stderr.encodings == ["utf-8"]
