-- Run in a development project's SQL Editor after applying the migration.
-- All test rows are rolled back; existing requests are left alone.
begin;
do $$
declare
  request_id uuid := gen_random_uuid();
  test_date date := (current_timestamp at time zone 'Asia/Kolkata')::date + 2;
  first_result jsonb;
  repeated_result jsonb;
  test_ip text := repeat('a', 64);
  count_before bigint;
begin
  assert not has_table_privilege('anon', 'public.pickups', 'SELECT'), 'anon cannot read pickups';
  assert not has_table_privilege('authenticated', 'public.pickups', 'SELECT'), 'signed-in visitors cannot read pickups';
  assert not has_table_privilege('anon', 'public.pickups', 'INSERT'), 'anon cannot bypass the function';
  assert not has_function_privilege('anon', 'public.create_pickup(uuid,text,text,text,text,date,text,text)', 'EXECUTE'), 'anon cannot call the database function';
  assert (select relrowsecurity from pg_class where oid = 'public.pickups'::regclass), 'RLS is enabled';

  select count(*) into count_before from public.pickups;
  first_result := public.create_pickup(request_id, 'Test User', '9876500000', '123 Test Street', 'Mixed e-waste', test_date, '', test_ip);
  repeated_result := public.create_pickup(request_id, 'Test User', '9876500000', '123 Test Street', 'Mixed e-waste', test_date, '', test_ip);
  assert first_result = repeated_result, 'retry returns the original confirmation';
  assert (select count(*) from public.pickups) = count_before + 1, 'retry does not insert twice';

  begin
    perform public.create_pickup(request_id, 'Changed User', '9876500000', '123 Test Street', 'Mixed e-waste', test_date, '', test_ip);
    raise exception 'Changed retry must fail';
  exception when sqlstate '22023' then null;
  end;
  perform public.create_pickup(gen_random_uuid(), 'Test User', '9876500000', '123 Test Street', 'Mixed e-waste', test_date, '', test_ip);
  perform public.create_pickup(gen_random_uuid(), 'Test User', '9876500000', '123 Test Street', 'Mixed e-waste', test_date, '', test_ip);
  begin
    perform public.create_pickup(gen_random_uuid(), 'Test User', '9876500000', '123 Test Street', 'Mixed e-waste', test_date, '', test_ip);
    raise exception 'Fourth phone request must fail';
  exception when sqlstate 'PT429' then null;
  end;

  for i in 1..7 loop
    perform public.create_pickup(gen_random_uuid(), 'Test User', '98765000' || lpad(i::text, 2, '0'), '123 Test Street', 'Mixed e-waste', test_date, '', test_ip);
  end loop;
  begin
    perform public.create_pickup(gen_random_uuid(), 'Test User', '9876500099', '123 Test Street', 'Mixed e-waste', test_date, '', test_ip);
    raise exception 'Eleventh IP request must fail';
  exception when sqlstate 'PT429' then null;
  end;
end;
$$;
rollback;
