/** Old named chat migrations may first run before or after the account cutover. */
export function chatUserIdBootstrap(ddl: string): string {
  return `do $chat_bootstrap$
declare identity_type text;
begin
  select format_type(atttypid,atttypmod) into identity_type
    from pg_attribute where attrelid='users'::regclass and attname='id' and not attisdropped;
  if identity_type not in ('bigint','text') or identity_type is null then
    raise exception 'Unsupported account identity column type';
  end if;
  execute replace($chat_ddl$${ddl}$chat_ddl$, '__chat_user_id_type__', identity_type);
end $chat_bootstrap$;`
}
