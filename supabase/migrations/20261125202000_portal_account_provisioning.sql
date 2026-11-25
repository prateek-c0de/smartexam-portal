/*
# Portal-scoped account provisioning

Allows each student and faculty member to register / provision their own
persistent email + password account directly through their respective portal
(`portal_role` in ('student', 'teacher')), while preserving:
- Default `'student'` fallback whenever metadata is absent or unrecognized
- Strict rejection of `'admin'` from client metadata
- `guard_profile_update` trigger preventing any post-creation role escalation
  (a student account can never switch to teacher or admin).
*/

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_name text := public._clean_text(NEW.raw_user_meta_data ->> 'full_name', 120);
  v_portal_role text := coalesce(NEW.raw_user_meta_data ->> 'portal_role', '');
  v_assigned_role text := CASE WHEN v_portal_role = 'teacher' THEN 'teacher' ELSE 'student' END;
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (NEW.id, lower(coalesce(NEW.email, '')), v_name, v_assigned_role)
  ON CONFLICT (id) DO NOTHING;

  IF v_assigned_role = 'student' AND NEW.raw_user_meta_data ->> 'requested_role' = 'teacher' THEN
    INSERT INTO public.teacher_requests (user_id, institution)
    VALUES (NEW.id, public._clean_text(NEW.raw_user_meta_data ->> 'institution', 200))
    ON CONFLICT (user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
