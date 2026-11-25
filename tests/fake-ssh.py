"""A stand-in for ssh in tests/live.mjs: the "other machine" is this one.

    fake-ssh.py [-o OPTION]... -N -L 127.0.0.1:HERE:127.0.0.1:THERE TARGET   forward port HERE to THERE
    fake-ssh.py [-o OPTION]... TARGET COMMAND                                  run COMMAND with sh
"""
import os
import socket
import sys
import threading

args = sys.argv[1:]
if "-O" in args:
    sys.exit(255)   # no shared connection (ControlMaster)
rest, forward, i = [], None, 0
while i < len(args):
    if args[i] in ("-o", "-L"):
        if args[i] == "-L":
            forward = args[i + 1]
        i += 2
    elif args[i] in ("-N", "--"):
        i += 1
    else:
        rest.append(args[i])
        i += 1

if forward is None:
    os.execvp("sh", ["sh", "-c", " ".join(rest[1:])])

_, here, _, there = forward.split(":")
server = socket.create_server(("127.0.0.1", int(here)))


def pipe(a, b):
    try:
        while data := a.recv(65536):
            b.sendall(data)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


while True:
    conn, _ = server.accept()
    try:
        out = socket.create_connection(("127.0.0.1", int(there)))
    except OSError:
        conn.close()
        continue
    threading.Thread(target=pipe, args=(conn, out), daemon=True).start()
    threading.Thread(target=pipe, args=(out, conn), daemon=True).start()
