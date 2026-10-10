CREATE SCHEMA tenant;

CREATE TYPE tenant.order_status AS ENUM ('pending', 'complete', 'customer''s hold');

CREATE TABLE tenant.accounts (
  tenant_id bigint NOT NULL,
  id bigint NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE tenant.orders (
  tenant_id bigint NOT NULL,
  id bigint NOT NULL,
  account_id bigint,
  order_code varchar(40) NOT NULL,
  status tenant.order_status NOT NULL DEFAULT 'pending',
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, order_code),
  FOREIGN KEY (tenant_id, account_id)
    REFERENCES tenant.accounts (tenant_id, id)
    ON DELETE NO ACTION ON UPDATE CASCADE
);
