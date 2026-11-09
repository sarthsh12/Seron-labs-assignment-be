CREATE TABLE materials (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL,
  category   text NOT NULL,
  unit       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz -- soft delete: old deliveries still point at it
);
CREATE UNIQUE INDEX materials_name_unique_idx ON materials (lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX materials_name_trgm_idx ON materials USING gin (name gin_trgm_ops);
CREATE INDEX materials_category_idx ON materials (category);

-- One company store plus one store per project, so stock and deliveries use a single store_id.
CREATE TABLE stores (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind       text   NOT NULL CHECK (kind IN ('company', 'project')),
  project_id bigint UNIQUE REFERENCES projects(id),
  CHECK ((kind = 'company') = (project_id IS NULL))
);
CREATE UNIQUE INDEX stores_single_company_idx ON stores (kind) WHERE kind = 'company';
INSERT INTO stores (kind) VALUES ('company');

-- CHECK (quantity >= 0) is the last line of defence against negative stock.
CREATE TABLE store_stock (
  store_id         bigint NOT NULL REFERENCES stores(id),
  material_id      bigint NOT NULL REFERENCES materials(id),
  quantity         numeric(14, 3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  in_transit_out   numeric(14, 3) NOT NULL DEFAULT 0 CHECK (in_transit_out >= 0),
  reorder_point    numeric(14, 3) NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
  last_movement_at timestamptz,
  PRIMARY KEY (store_id, material_id)
);
CREATE INDEX store_stock_material_idx ON store_stock (material_id);
