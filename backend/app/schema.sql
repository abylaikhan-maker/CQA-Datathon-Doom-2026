CREATE TABLE IF NOT EXISTS conversations (
    id              TEXT PRIMARY KEY,
    dataset_group   TEXT NOT NULL DEFAULT 'UPLOAD',
    channel         TEXT,
    language        TEXT,
    transcript      JSONB NOT NULL,
    audio_url       TEXT,
    raw             JSONB,
    imported_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_group_idx ON conversations (dataset_group);

-- Every save of a checklist creates a new immutable version.
CREATE TABLE IF NOT EXISTS checklists (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    version     INT NOT NULL,
    config      JSONB NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT false,
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evaluations (
    id               SERIAL PRIMARY KEY,
    conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    checklist_id     INT NOT NULL REFERENCES checklists(id),
    status           TEXT NOT NULL DEFAULT 'pending',      -- pending | running | done | error
    error            TEXT,
    provider         TEXT,
    model            TEXT,
    criteria         JSONB,        -- original per-criterion results from the model
    score            JSONB,        -- original computed score
    total            NUMERIC(8,2),
    critical         BOOLEAN,
    final_criteria   JSONB,        -- after reviewer decisions
    final_score      JSONB,
    final_total      NUMERIC(8,2),
    summary          TEXT,
    usage            JSONB,
    cost_usd         NUMERIC(12,6),
    duration_ms      INT,
    batch_id         INT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS evaluations_conv_idx ON evaluations (conversation_id, id DESC);

CREATE TABLE IF NOT EXISTS appeals (
    id              SERIAL PRIMARY KEY,
    evaluation_id   INT NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
    criterion_id    TEXT NOT NULL,
    comment         TEXT NOT NULL,
    author          TEXT,
    status          TEXT NOT NULL DEFAULT 'open',       -- open | confirmed | changed
    original_answer JSONB,
    new_answer      JSONB,
    reason          TEXT,
    reviewer        TEXT,
    total_before    NUMERIC(8,2),
    total_after     NUMERIC(8,2),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS batches (
    id            SERIAL PRIMARY KEY,
    dataset_group TEXT,
    checklist_id  INT REFERENCES checklists(id),
    total         INT NOT NULL DEFAULT 0,
    done          INT NOT NULL DEFAULT 0,
    failed        INT NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'running',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ
);
