import { resolveProfileById, resolveProfileFromPath, type ResolvedProfile } from './profile-resolver.js';

interface StartupProfileOptions {
  specPathEnv?: string;
  profilePath?: string;
  profileId?: string;
  profilesDir?: string;
}

interface StartupProfileResult {
  specPath?: string;
  profilePath?: string;
  profileId?: string;
  defaultProfile?: ResolvedProfile;
  hasExplicitSpecPath: boolean;
}

export async function resolveStartupProfile(options: StartupProfileOptions): Promise<StartupProfileResult> {
  const hasExplicitSpecPath = !!options.specPathEnv;
  let specPath = options.specPathEnv;
  let profilePath = options.profilePath;
  let profileId = options.profileId;
  let defaultProfile: ResolvedProfile | undefined;

  if (!profilePath && profileId) {
    const resolved = await resolveProfileById(profileId, options.profilesDir, { specPathOverride: specPath });
    defaultProfile = resolved;
    profilePath = resolved.profilePath;
    profileId = resolved.profileId;
    specPath = resolved.specPath;
  } else if (profilePath) {
    const resolved = await resolveProfileFromPath(profilePath, { specPathOverride: specPath });
    defaultProfile = resolved;
    profilePath = resolved.profilePath;
    profileId = resolved.profileId;
    specPath = resolved.specPath;
  }

  return {
    specPath,
    profilePath,
    profileId,
    defaultProfile,
    hasExplicitSpecPath,
  };
}
