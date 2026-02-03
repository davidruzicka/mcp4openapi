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
import { ConfigurationError } from '../core/errors.js';
import { isProfileAllowed, type ProfileAllowlistConfig } from './profile-allowlist.js';

export interface ProfileRegistryOptions {
  profilesDir?: string;
  defaultProfile?: ResolvedProfile;
  specPathOverride?: string;
  allowlist?: ProfileAllowlistConfig | null;
}

export class ProfileRegistry {
  private profilesDir?: string;
  private defaultProfile?: ResolvedProfile;
  private specPathOverride?: string;
  private allowlist: ProfileAllowlistConfig | null;

  constructor(options: ProfileRegistryOptions) {
    this.profilesDir = options.profilesDir;
    this.defaultProfile = options.defaultProfile;
    this.specPathOverride = options.specPathOverride;
    this.allowlist = options.allowlist ?? null;
  }

  getDefaultProfile(): ResolvedProfile | undefined {
    if (!this.defaultProfile) {
      return undefined;
    }
    return this.isAllowed(this.defaultProfile) ? this.defaultProfile : undefined;
  }

  async resolveProfile(profileId: string): Promise<ResolvedProfile> {
    const defaultProfile = this.getDefaultProfile();
    if (defaultProfile) {
      if (profileId === defaultProfile.profileId || profileId === defaultProfile.profileName) {
        return defaultProfile;
      }
      if (defaultProfile.profileAliases?.includes(profileId)) {
        return defaultProfile;
      }
    }

    const resolved = await resolveProfileById(profileId, this.profilesDir, { specPathOverride: this.specPathOverride });
    if (!this.isAllowed(resolved)) {
      throw new ConfigurationError('Profile not found', {
        profileId,
        reason: 'not_allowed',
      });
    }
    return resolved;
  }

  async listProfilesForIndex(): Promise<ListedProfileDetails[]> {
    const profiles = this.filterProfiles(await listProfilesDetailed(this.profilesDir));
    const defaultProfile = this.getDefaultProfile();
    if (!defaultProfile) {
      return profiles;
    }

    const existing = profiles.find(profile =>
      profile.profileId === defaultProfile.profileId ||
      profile.profileName === defaultProfile.profileName ||
      profile.profileAliases.includes(defaultProfile.profileId)
    );

    if (existing) {
      return profiles;
    }

    const defaultDetails = await resolveProfileDetailsFromPath(defaultProfile.profilePath);
    if (defaultDetails && this.isAllowed(defaultDetails)) {
      return [defaultDetails, ...profiles];
    }

    return profiles;
  }

  private isAllowed(profile: { profileId: string; profileName: string; profileAliases?: string[] }): boolean {
    return isProfileAllowed(profile, this.allowlist);
  }

  private filterProfiles<T extends { profileId: string; profileName: string; profileAliases?: string[] }>(profiles: T[]): T[] {
    if (!this.allowlist) {
      return profiles;
    }
    return profiles.filter(profile => this.isAllowed(profile));
  }
}
