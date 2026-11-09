-- Every delivery runs between the company store and one project store; direction says which way.
CREATE TABLE deliveries (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id  bigint NOT NULL REFERENCES projects(id),
  direction   text   NOT NULL CHECK (direction IN ('to_project', 'to_company')),
  status      text   NOT NULL DEFAULT 'in_transit'
              CHECK (status IN ('in_transit', 'delivered', 'rejected', 'cancelled')),
  sent_by     bigint NOT NULL REFERENCES users(id),
  sent_at     timestamptz NOT NULL DEFAULT now(),
  resolved_by bigint REFERENCES users(id), -- who recorded, rejected or cancelled it
  resolved_at timestamptz,
  CHECK ((status = 'in_transit') = (resolved_at IS NULL))
);
CREATE INDEX deliveries_project_sent_idx ON deliveries (project_id, sent_at DESC);
CREATE INDEX deliveries_sent_idx ON deliveries (sent_at DESC);
CREATE INDEX deliveries_in_transit_idx ON deliveries (project_id) WHERE status = 'in_transit';

CREATE TABLE delivery_lines (
  delivery_id bigint NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  material_id bigint NOT NULL REFERENCES materials(id),
  quantity    numeric(14, 3) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (delivery_id, material_id)
);
CREATE INDEX delivery_lines_material_idx ON delivery_lines (material_id);
