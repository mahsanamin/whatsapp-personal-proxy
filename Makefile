.PHONY: init up down logs dev

init:
	mkdir -p data/db data/wa-session data/media
	cp -n .env.example .env || true
	@echo "Edit .env then run: make up"

up:
	docker compose up -d --build

dev:
	docker compose up --build

down:
	docker compose down

logs:
	docker compose logs -f
