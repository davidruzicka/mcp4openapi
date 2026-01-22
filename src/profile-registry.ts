/**
 * Profile registry for resolving profiles by ID or alias.
 */

import { resolveProfileById, type ResolvedProfile } from './profile-resolver.js';

export interface ProfileRegistryOptions {
  profilesDir?: string;
  defaultProfile?: ResolvedProfile;
}

export class ProfileRegistry {
  private profilesDir?: string;
  private defaultProfile?: ResolvedProfile;

  constructor(options: ProfileRegistryOptions) {
    this.profilesDir = options.profilesDir;
    this.defaultProfile = options.defaultProfile;
  }

  getDefaultProfile(): ResolvedProfile | undefined {
    return this.defaultProfile;
  }

  async resolveProfile(profileId: string): Promise<ResolvedProfile> {
    if (this.defaultProfile) {
      if (profileId === this.defaultProfile.profileId || profileId === this.defaultProfile.profileName) {
        return this.defaultProfile;
      }
    }

    return resolveProfileById(profileId, this.profilesDir);
  }
}
