begin;

create table public.pickups (
  request_id uuid primary key,
  reference text not null unique default ('LB-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))),
  name text not null check (char_length(name) between 2 and 100),
  phone text not null check (phone ~ '^[6-9][0-9]{9}$'),
  address text not null check (char_length(address) between 8 and 1000),
  item_type text not null check (item_type in ('Mixed e-waste', 'Phones and tablets', 'Computers', 'Home appliances', 'Batteries and chargers')),
  preferred_date date not null,
  notes text not null default '' check (char_length(notes) <= 1000),
  status text not null default 'requested' check (status in ('requested', 'confirmed', 'collected', 'cancelled')),
  ip_hash text not null check (ip_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now()
);

create index pickups_phone_created_at on public.pickups (phone, created_at);
create index pickups_ip_created_at on public.pickups (ip_hash, created_at);

alter table public.pickups enable row level security;
revoke all on public.pickups from public, anon, authenticated;
grant select, insert, update, delete on public.pickups to service_role;

create function public.create_pickup(
  p_request_id uuid, p_name text, p_phone text, p_address text,
  p_item_type text, p_preferred_date date, p_notes text, p_ip_hash text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing public.pickups%rowtype;
  result jsonb;
begin
  -- Locks make retries and limits atomic across simultaneous function instances.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text, 0));
  select * into existing from public.pickups where request_id = p_request_id;
  if found then
    if row(existing.name, existing.phone, existing.address, existing.item_type, existing.preferred_date, existing.notes)
       is distinct from row(p_name, p_phone, p_address, p_item_type, p_preferred_date, p_notes) then
      raise exception using errcode = '22023', message = 'request_mismatch';
    end if;
    return jsonb_build_object('reference', existing.reference, 'preferred_date', existing.preferred_date);
  end if;

  if p_preferred_date < (current_timestamp at time zone 'Asia/Kolkata')::date + 1 then
    raise exception using errcode = '22023', message = 'invalid_date';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('phone:' || p_phone, 0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ip:' || p_ip_hash, 0));
  if (select count(*) from public.pickups where phone = p_phone and created_at > now() - interval '1 hour') >= 3
     or (select count(*) from public.pickups where ip_hash = p_ip_hash and created_at > now() - interval '1 hour') >= 10 then
    raise exception using errcode = 'PT429', message = 'rate_limited';
  end if;

  insert into public.pickups (request_id, name, phone, address, item_type, preferred_date, notes, ip_hash)
  values (p_request_id, p_name, p_phone, p_address, p_item_type, p_preferred_date, p_notes, p_ip_hash)
  returning jsonb_build_object('reference', reference, 'preferred_date', preferred_date) into result;
  return result;
end;
$$;

revoke all on function public.create_pickup(uuid, text, text, text, text, date, text, text) from public, anon, authenticated;
grant execute on function public.create_pickup(uuid, text, text, text, text, date, text, text) to service_role;

commit;
