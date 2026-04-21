-- Git integration settings
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_template_vendor_ostype_name'
  ) THEN
    ALTER TABLE config_templates ADD CONSTRAINT uq_template_vendor_ostype_name UNIQUE (vendor, os_type, name);
  END IF;
END $$;

INSERT INTO settings (key, label, description, category) VALUES
  ('git.backup_enabled',      'Config Backup Enabled',    'Set to "true" to enable automatic git backup of running configs', 'git'),
  ('git.backup_repo_url',     'Backup Repository URL',    'HTTPS git repository URL for config backups (e.g. https://github.com/org/repo.git)', 'git'),
  ('git.backup_branch',       'Backup Branch',            'Branch to commit config backups to (defaults to main)', 'git'),
  ('git.backup_token',        'Backup Access Token',      'Personal access token for HTTPS git authentication', 'git'),
  ('git.backup_author_name',  'Git Author Name',          'Name to use in git commits (defaults to ZTP Server)', 'git'),
  ('git.backup_author_email', 'Git Author Email',         'Email to use in git commits', 'git'),
  ('git.template_repo_url',   'Template Repository URL',  'HTTPS git repository URL containing config templates', 'git'),
  ('git.template_branch',     'Template Branch',          'Branch to pull templates from (defaults to main)', 'git'),
  ('git.template_token',      'Template Access Token',    'Personal access token for HTTPS git authentication', 'git'),
  ('git.template_path',       'Template Path Prefix',     'Subdirectory within template repo where vendor folders live (leave blank for root)', 'git')
ON CONFLICT (key) DO NOTHING;
