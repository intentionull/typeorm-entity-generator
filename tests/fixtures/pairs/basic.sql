CREATE TABLE public.accounts (
  id integer PRIMARY KEY,
  email varchar(255) NOT NULL UNIQUE,
  enabled boolean DEFAULT true,
  balance numeric(12,2) NOT NULL DEFAULT 0,
  nickname text,
  created_at timestamp DEFAULT now()
);
