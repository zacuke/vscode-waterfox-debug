// This is just a dummy declaration so that we can use the firefox-profile package
declare module "firefox-profile" {
	function FirefoxProfile();
	namespace FirefoxProfile{}
	export = FirefoxProfile;
}

declare module "firefox-profile/lib/profile_finder" {
	class ProfileFinder {
		getPath(name: string, cb: (err: any, profilePath: string) => void);
	}
	namespace ProfileFinder{}
	export = ProfileFinder;
}