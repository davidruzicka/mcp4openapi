/**
 * Profile registry for resolving profiles by ID or alias.
 */

import {
  resolveProfileById,
  listProfilesDetailed,
  resolveProfileDetailsFromPath,
  type ResolvedProfile,
  type ListedProfileDetails,
} from './profile-resolver.js';

export interface ProfileRegistryOptions {
  profilesDir?: string;
  defaultProfile?: ResolvedProfile;
  specPathOverride?: string;
}

export class ProfileRegistry {
  private profilesDir?: string;
  private defaultProfile?: ResolvedProfile;
  private specPathOverride?: string;

  constructor(options: ProfileRegistryOptions) {
    this.profilesDir = options.profilesDir;
    this.defaultProfile = options.defaultProfile;
    this.specPathOverride = options.specPathOverride;
  }

  getDefaultProfile(): ResolvedProfile | undefined {
    return this.defaultProfile;
  }

  async resolveProfile(profileId: string): Promise<ResolvedProfile> {
    if (this.defaultProfile) {
      if (profileId === this.defaultProfile.profileId || profileId === this.defaultProfile.profileName) {
        return this.defaultProfile;
      }
      if (this.defaultProfile.profileAliases?.includes(profileId)) {
        return this.defaultProfile;
      }
    }

    return resolveProfileById(profileId, this.profilesDir, { specPathOverride: this.specPathOverride });
  }

  async listProfilesForIndex(): Promise<ListedProfileDetails[]> {
    const profiles = await listProfilesDetailed(this.profilesDir);
    if (!this.defaultProfile) {
      return profiles;
    }

    const existing = profiles.find(profile =>
      profile.profileId === this.defaultProfile!.profileId ||
      profile.profileName === this.defaultProfile!.profileName ||
      profile.profileAliases.includes(this.defaultProfile!.profileId)
    );

    if (existing) {
      return profiles;
    }

    const defaultDetails = await resolveProfileDetailsFromPath(this.defaultProfile.profilePath);
    if (defaultDetails) {
      return [defaultDetails, ...profiles];
    }

    return profiles;
  }
}
