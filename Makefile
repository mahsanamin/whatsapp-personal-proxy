# Thin wrapper over ./proxy, which is the canonical entry point.
.PHONY: init up down dev logs status build test cli

init:   ; @./proxy init
up:     ; @./proxy start
dev:    ; @./proxy dev
down:   ; @./proxy stop
logs:   ; @./proxy logs
status: ; @./proxy status
build:  ; @./proxy build
test:   ; @./proxy test
cli:    ; @./proxy cli
