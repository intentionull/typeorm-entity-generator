CREATE SCHEMA "Sales Team";

CREATE TABLE "Sales Team"."Member Record" (
  "Member Id" integer PRIMARY KEY,
  "Manager Id" integer REFERENCES "Sales Team"."Member Record" ("Member Id"),
  "Display Name" varchar(80) NOT NULL
);

CREATE INDEX "Member Manager Index"
  ON "Sales Team"."Member Record" USING btree ("Manager Id");
