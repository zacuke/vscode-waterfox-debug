// This is just a dummy declaration so that we can use the firefox-profile package
declare module "firefox-profile";

declare module "firefox-profile/lib/profile_finder" {
	class ProfileFinder {
		getPath(name: string, cb: (err: any, profilePath: string) => void): void;
	}
	namespace ProfileFinder{}
	export = ProfileFinder;
}