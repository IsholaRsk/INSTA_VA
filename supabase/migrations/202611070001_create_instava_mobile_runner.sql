CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;

CREATE TABLE IF NOT EXISTS public.instava_mobile_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pseudo text NOT NULL CHECK (char_length(trim(pseudo)) BETWEEN 1 AND 60),
  url text NOT NULL CHECK (char_length(url) <= 2048),
  link_label text NOT NULL CHECK (char_length(trim(link_label)) BETWEEN 1 AND 100),
  execution_target integer NOT NULL CHECK (execution_target BETWEEN 1 AND 50),
  duration_weeks integer NOT NULL CHECK (duration_weeks BETWEEN 1 AND 52),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS instava_mobile_targets_user_created_idx
  ON public.instava_mobile_targets (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.instava_mobile_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'running', 'completed', 'stopped', 'failed')),
  confirm_clicks boolean NOT NULL DEFAULT false,
  target_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS instava_mobile_runs_user_created_idx
  ON public.instava_mobile_runs (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS instava_mobile_one_active_run_per_user_idx
  ON public.instava_mobile_runs (user_id) WHERE status IN ('scheduled', 'running');

CREATE TABLE IF NOT EXISTS public.instava_mobile_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.instava_mobile_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES public.instava_mobile_targets(id) ON DELETE CASCADE,
  pseudo_snapshot text NOT NULL CHECK (char_length(pseudo_snapshot) BETWEEN 1 AND 60),
  visit_number integer NOT NULL CHECK (visit_number > 0),
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'success', 'failed', 'approval_required', 'cancelled')),
  approved_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, target_id, visit_number)
);

CREATE INDEX IF NOT EXISTS instava_mobile_visits_due_idx
  ON public.instava_mobile_visits (scheduled_at, id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS instava_mobile_visits_user_created_idx
  ON public.instava_mobile_visits (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.instava_mobile_proxy_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  secret_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.instava_mobile_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instava_mobile_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instava_mobile_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instava_mobile_proxy_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instava_targets_owner_select ON public.instava_mobile_targets;
CREATE POLICY instava_targets_owner_select ON public.instava_mobile_targets
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS instava_targets_owner_insert ON public.instava_mobile_targets;
CREATE POLICY instava_targets_owner_insert ON public.instava_mobile_targets
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS instava_targets_owner_update ON public.instava_mobile_targets;
CREATE POLICY instava_targets_owner_update ON public.instava_mobile_targets
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS instava_targets_owner_delete ON public.instava_mobile_targets;
CREATE POLICY instava_targets_owner_delete ON public.instava_mobile_targets
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS instava_runs_owner_select ON public.instava_mobile_runs;
CREATE POLICY instava_runs_owner_select ON public.instava_mobile_runs
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS instava_visits_owner_select ON public.instava_mobile_visits;
CREATE POLICY instava_visits_owner_select ON public.instava_mobile_visits
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.instava_mobile_targets TO authenticated;
GRANT SELECT ON public.instava_mobile_runs, public.instava_mobile_visits TO authenticated;
REVOKE ALL ON public.instava_mobile_proxy_settings FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.instava_claim_due_visits(p_limit integer DEFAULT 5)
RETURNS SETOF public.instava_mobile_visits
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  candidate record;
  claimed public.instava_mobile_visits;
BEGIN
  WITH stale AS (
    UPDATE public.instava_mobile_visits
    SET status = 'failed', completed_at = now(), result = jsonb_build_object('message', 'Cycle interrompu par une limite du worker.')
    WHERE status = 'running' AND started_at < now() - interval '10 minutes'
    RETURNING run_id
  ), stale_runs AS (
    SELECT DISTINCT run_id FROM stale
  )
  UPDATE public.instava_mobile_runs AS run
  SET status = CASE
        WHEN EXISTS (SELECT 1 FROM public.instava_mobile_visits v WHERE v.run_id = run.id AND v.status = 'running') THEN 'running'
        WHEN EXISTS (SELECT 1 FROM public.instava_mobile_visits v WHERE v.run_id = run.id AND v.status IN ('pending', 'approval_required')) THEN 'scheduled'
        WHEN EXISTS (SELECT 1 FROM public.instava_mobile_visits v WHERE v.run_id = run.id)
          AND NOT EXISTS (SELECT 1 FROM public.instava_mobile_visits v WHERE v.run_id = run.id AND v.status <> 'cancelled') THEN 'stopped'
        ELSE 'completed'
      END,
      finished_at = CASE
        WHEN EXISTS (SELECT 1 FROM public.instava_mobile_visits v WHERE v.run_id = run.id AND v.status IN ('pending', 'running', 'approval_required')) THEN NULL
        ELSE now()
      END
  WHERE run.id IN (SELECT run_id FROM stale_runs);

  FOR candidate IN
    SELECT picked.id, picked.target_id
    FROM (
      SELECT DISTINCT ON (visit.target_id) visit.id, visit.target_id, visit.scheduled_at
      FROM public.instava_mobile_visits AS visit
      WHERE visit.status = 'pending' AND visit.scheduled_at <= now()
        AND NOT EXISTS (
          SELECT 1 FROM public.instava_mobile_visits AS active
          WHERE active.target_id = visit.target_id AND active.status IN ('running', 'approval_required')
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.instava_mobile_visits AS recent
          WHERE recent.target_id = visit.target_id
            AND recent.status IN ('success', 'failed')
            AND recent.completed_at > now() - interval '5 minutes'
        )
      ORDER BY visit.target_id, visit.scheduled_at, visit.id
    ) AS picked
    ORDER BY picked.scheduled_at, picked.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 5), 1), 20)
  LOOP
    -- Serialize claims per target so simultaneous start/cron requests cannot run it twice.
    PERFORM 1 FROM public.instava_mobile_targets AS target
      WHERE target.id = candidate.target_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    UPDATE public.instava_mobile_visits AS visit
    SET status = 'running', started_at = now()
    WHERE visit.id = candidate.id AND visit.status = 'pending' AND visit.scheduled_at <= now()
      AND NOT EXISTS (
        SELECT 1 FROM public.instava_mobile_visits AS active
        WHERE active.target_id = visit.target_id AND active.status IN ('running', 'approval_required')
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.instava_mobile_visits AS recent
        WHERE recent.target_id = visit.target_id
          AND recent.status IN ('success', 'failed')
          AND recent.completed_at > now() - interval '5 minutes'
      )
    RETURNING visit.* INTO claimed;

    IF FOUND THEN
      RETURN NEXT claimed;
    END IF;
  END LOOP;
  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.instava_claim_due_visits(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.instava_claim_due_visits(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.instava_claim_visit(p_visit_id uuid)
RETURNS SETOF public.instava_mobile_visits
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_key uuid;
  claimed public.instava_mobile_visits;
BEGIN
  SELECT visit.target_id INTO target_key
  FROM public.instava_mobile_visits AS visit
  WHERE visit.id = p_visit_id AND visit.status = 'pending' AND visit.scheduled_at <= now();
  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM 1 FROM public.instava_mobile_targets AS target
    WHERE target.id = target_key FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.instava_mobile_visits AS visit
  SET status = 'running', started_at = now()
  WHERE visit.id = p_visit_id AND visit.status = 'pending' AND visit.scheduled_at <= now()
    AND NOT EXISTS (
      SELECT 1 FROM public.instava_mobile_visits AS active
      WHERE active.target_id = visit.target_id AND active.status IN ('running', 'approval_required')
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.instava_mobile_visits AS recent
      WHERE recent.target_id = visit.target_id
        AND recent.status IN ('success', 'failed')
        AND recent.completed_at > now() - interval '5 minutes'
    )
  RETURNING visit.* INTO claimed;

  IF FOUND THEN
    RETURN NEXT claimed;
  END IF;
  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.instava_claim_visit(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.instava_claim_visit(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.instava_replace_proxy_secret(p_user_id uuid, p_secret jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  existing_secret_id uuid;
  created_secret_id uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'utilisateur invalide';
  END IF;

  IF p_secret IS NULL THEN
    DELETE FROM public.instava_mobile_proxy_settings WHERE user_id = p_user_id;
    RETURN;
  END IF;

  IF jsonb_typeof(p_secret) <> 'object'
     OR char_length(coalesce(p_secret->>'host', '')) NOT BETWEEN 1 AND 253
     OR char_length(coalesce(p_secret->>'username', '')) NOT BETWEEN 1 AND 512
     OR char_length(coalesce(p_secret->>'password', '')) NOT BETWEEN 1 AND 512
     OR coalesce(p_secret->>'scheme', '') NOT IN ('http', 'https', 'socks5')
     OR coalesce((p_secret->>'port')::integer, 0) NOT BETWEEN 1 AND 65535 THEN
    RAISE EXCEPTION 'configuration proxy invalide';
  END IF;

  SELECT secret_id INTO existing_secret_id
    FROM public.instava_mobile_proxy_settings WHERE user_id = p_user_id;

  IF existing_secret_id IS NULL THEN
    SELECT vault.create_secret(
      p_secret::text,
      'instava_mobile_proxy_' || p_user_id::text,
      'Webshare credentials for the InstaVA mobile runner'
    ) INTO created_secret_id;

    INSERT INTO public.instava_mobile_proxy_settings (user_id, secret_id, updated_at)
    VALUES (p_user_id, created_secret_id, now())
    ON CONFLICT (user_id) DO UPDATE SET secret_id = EXCLUDED.secret_id, updated_at = now();
  ELSE
    PERFORM vault.update_secret(existing_secret_id, p_secret::text);
    UPDATE public.instava_mobile_proxy_settings SET updated_at = now() WHERE user_id = p_user_id;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.instava_get_proxy_secret(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT decrypted.decrypted_secret::jsonb
  FROM public.instava_mobile_proxy_settings AS mapping
  JOIN vault.decrypted_secrets AS decrypted ON decrypted.id = mapping.secret_id
  WHERE mapping.user_id = p_user_id
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.instava_cleanup_proxy_vault_secret()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  DELETE FROM vault.secrets WHERE id = OLD.secret_id;
  RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS instava_mobile_proxy_cleanup_secret ON public.instava_mobile_proxy_settings;
CREATE TRIGGER instava_mobile_proxy_cleanup_secret
  AFTER DELETE ON public.instava_mobile_proxy_settings
  FOR EACH ROW EXECUTE FUNCTION public.instava_cleanup_proxy_vault_secret();

REVOKE ALL ON FUNCTION public.instava_replace_proxy_secret(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instava_get_proxy_secret(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instava_cleanup_proxy_vault_secret() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.instava_replace_proxy_secret(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.instava_get_proxy_secret(uuid) TO service_role;
