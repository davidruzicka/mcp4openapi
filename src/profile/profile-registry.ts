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
import { isProfileAllowed, isProfileHidden, type ProfileAllowlistConfig } from './profile-filters.js';

export interface ProfileRegistryOptions {
  profilesDir?: string;
  defaultProfile?: ResolvedProfile;
  specPathOverride?: string;
  allowlist?: ProfileAllowlistConfig | null;
  hidelist?: string[];
}

export class ProfileRegistry {
  private profilesDir?: string;
  private defaultProfile?: ResolvedProfile;
  private specPathOverride?: string;
  private allowlist: ProfileAllowlistConfig | null;
  private hidelist: Set<string>;

  constructor(options: ProfileRegistryOptions) {
    this.profilesDir = options.profilesDir;
    this.defaultProfile = options.defaultProfile;
    this.specPathOverride = options.specPathOverride;
    this.allowlist = options.allowlist ?? null;
    this.hidelist = new Set(options.hidelist ?? []);
  }

  getDefaultProfile(): ResolvedProfile | undefined {
    if (!this.defaultProfile) {
      return undefined;
    }
    // Intentionally does not check hidelist: hidden profiles remain fully routable.
    // Index filtering is the only effect of hidelist (applied in listProfilesForIndex).
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
    if (defaultDetails && this.isAllowed(defaultDetails) && !this.isHidden(defaultDetails)) {
      return [defaultDetails, ...profiles];
    }

    return profiles;
  }

  private isAllowed(profile: { profileId: string; profileName: string; profileAliases?: string[] }): boolean {
    return isProfileAllowed(profile, this.allowlist);
  }

  private isHidden(profile: { profileId: string; profileName: string; profileAliases?: string[] }): boolean {
    return isProfileHidden(profile, this.hidelist);
  }

  private filterProfiles<T extends { profileId: string; profileName: string; profileAliases?: string[] }>(profiles: T[]): T[] {
    let result = profiles;
    if (this.allowlist) {
      result = result.filter(profile => this.isAllowed(profile));
    }
    if (this.hidelist.size > 0) {
      result = result.filter(profile => !this.isHidden(profile));
    }
    return result;
  }
}
