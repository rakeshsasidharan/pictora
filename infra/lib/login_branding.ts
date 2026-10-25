import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CfnManagedLoginBranding } from 'aws-cdk-lib/aws-cognito';
import type { Construct } from 'constructs';

/** The app icon shown above the sign-in form, the same one as the sidebar and site header. */
export const LOGIN_LOGO_PATH = fileURLToPath(
  new URL('../../app/public/icons/icon_192.png', import.meta.url),
);

/** The app's favicon, so the sign-in tab looks like the rest of Pictora. */
export const LOGIN_FAVICON_PATH = fileURLToPath(
  new URL('../../app/src/app/favicon.ico', import.meta.url),
);

/**
 * The shadcn theme tokens from `app/src/app/globals.css` (base colour neutral), as the `RRGGBBAA` hex colours
 * the managed login settings take. The neutral greys are the exact sRGB values of the `oklch` tokens;
 * translucent dark-mode borders and inputs are blended over the card colour, since the form sits on a card.
 */
export const LOGIN_COLOURS = {
  light: {
    background: 'ffffffff',
    foreground: '0a0a0aff',
    card: 'ffffffff',
    primary: '171717ff',
    primaryHover: '171717e6',
    primaryForeground: 'fafafaff',
    secondary: 'f5f5f5ff',
    secondaryHover: 'e5e5e5ff',
    secondaryForeground: '171717ff',
    accent: 'f5f5f5ff',
    mutedForeground: '737373ff',
    border: 'e5e5e5ff',
    input: 'e5e5e5ff',
    inputBackground: 'ffffffff',
    ring: 'a1a1a1ff',
    destructive: 'e7000bff',
    destructiveBackground: 'fef2f2ff',
    success: '16a34aff',
    successBackground: 'f0fdf4ff',
    warning: 'ca8a04ff',
    warningBackground: 'fefce8ff',
    chrome: 'fafafaff',
  },
  dark: {
    background: '0a0a0aff',
    foreground: 'fafafaff',
    card: '171717ff',
    primary: 'e5e5e5ff',
    primaryHover: 'e5e5e5e6',
    primaryForeground: '171717ff',
    secondary: '262626ff',
    secondaryHover: '333333ff',
    secondaryForeground: 'fafafaff',
    accent: '262626ff',
    mutedForeground: 'a1a1a1ff',
    border: '2e2e2eff',
    input: '3a3a3aff',
    inputBackground: '212121ff',
    ring: '737373ff',
    destructive: 'ff6467ff',
    destructiveBackground: '460809ff',
    success: '4ade80ff',
    successBackground: '052e16ff',
    warning: 'facc15ff',
    warningBackground: '422006ff',
    chrome: '171717ff',
  },
} as const;

type Palette = (typeof LOGIN_COLOURS)['light' | 'dark'];

/** Radii in pixels from `--radius` (10 px): buttons and inputs are `rounded-md`, the card `rounded-xl`. */
export const LOGIN_RADIUS = { control: 8, alert: 10, form: 14 } as const;

/** Builds one value per colour mode, in the `{ lightMode, darkMode }` shape the settings use throughout. */
function modes<T>(build: (colours: Palette) => T): { lightMode: T; darkMode: T } {
  return { lightMode: build(LOGIN_COLOURS.light), darkMode: build(LOGIN_COLOURS.dark) };
}

/**
 * The managed login settings document (tech design 8): the app's colours, radii and light and dark mode, which
 * follows the browser, the Pictora icon above a centred form, and Continue with Google above email and password.
 */
export function loginBrandingSettings(): Record<string, unknown> {
  return {
    categories: {
      auth: {
        authMethodOrder: [
          [
            { display: 'BUTTON', type: 'FEDERATED' },
            { display: 'INPUT', type: 'USERNAME_PASSWORD' },
          ],
        ],
        federation: { interfaceStyle: 'BUTTON_LIST', order: [] },
      },
      form: {
        displayGraphics: true,
        instructions: { enabled: false },
        languageSelector: { enabled: false },
        location: { horizontal: 'CENTER', vertical: 'CENTER' },
        sessionTimerDisplay: 'NONE',
      },
      global: {
        colorSchemeMode: 'DYNAMIC',
        pageFooter: { enabled: false },
        pageHeader: { enabled: false },
        spacingDensity: 'REGULAR',
      },
      signUp: { acceptanceElements: [{ enforcement: 'NONE', textKey: 'en' }] },
    },
    componentClasses: {
      buttons: { borderRadius: LOGIN_RADIUS.control },
      divider: modes((c) => ({ borderColor: c.border })),
      dropDown: {
        borderRadius: LOGIN_RADIUS.control,
        ...modes((c) => ({
          defaults: { itemBackgroundColor: c.card },
          hover: {
            itemBackgroundColor: c.accent,
            itemBorderColor: c.input,
            itemTextColor: c.foreground,
          },
          match: { itemBackgroundColor: c.accent, itemTextColor: c.foreground },
        })),
      },
      focusState: modes((c) => ({ borderColor: c.ring })),
      idpButtons: { icons: { enabled: true } },
      input: {
        borderRadius: LOGIN_RADIUS.control,
        ...modes((c) => ({
          defaults: { backgroundColor: c.inputBackground, borderColor: c.input },
          placeholderColor: c.mutedForeground,
        })),
      },
      inputDescription: modes((c) => ({ textColor: c.mutedForeground })),
      inputLabel: modes((c) => ({ textColor: c.foreground })),
      link: modes((c) => ({
        defaults: { textColor: c.foreground },
        hover: { textColor: c.mutedForeground },
      })),
      optionControls: modes((c) => ({
        defaults: { backgroundColor: c.inputBackground, borderColor: c.input },
        selected: { backgroundColor: c.primary, foregroundColor: c.primaryForeground },
      })),
      statusIndicator: modes((c) => ({
        error: {
          backgroundColor: c.destructiveBackground,
          borderColor: c.destructive,
          indicatorColor: c.destructive,
        },
        pending: { indicatorColor: c.mutedForeground },
        success: {
          backgroundColor: c.successBackground,
          borderColor: c.success,
          indicatorColor: c.success,
        },
        warning: {
          backgroundColor: c.warningBackground,
          borderColor: c.warning,
          indicatorColor: c.warning,
        },
      })),
    },
    components: {
      alert: {
        borderRadius: LOGIN_RADIUS.alert,
        ...modes((c) => ({
          error: { backgroundColor: c.destructiveBackground, borderColor: c.destructive },
        })),
      },
      favicon: { enabledTypes: ['ICO'] },
      form: {
        backgroundImage: { enabled: false },
        borderRadius: LOGIN_RADIUS.form,
        ...modes((c) => ({ backgroundColor: c.card, borderColor: c.border })),
        logo: { enabled: true, formInclusion: 'IN', location: 'CENTER', position: 'TOP' },
      },
      idpButton: {
        custom: {},
        // Styled like the app's outline buttons.
        standard: modes((c) => ({
          active: { backgroundColor: c.accent, borderColor: c.input, textColor: c.foreground },
          defaults: { backgroundColor: c.card, borderColor: c.input, textColor: c.foreground },
          hover: { backgroundColor: c.accent, borderColor: c.input, textColor: c.foreground },
        })),
      },
      // A plain page like the app's, rather than Cognito's default background image.
      pageBackground: { ...modes((c) => ({ color: c.background })), image: { enabled: false } },
      pageFooter: {
        backgroundImage: { enabled: false },
        ...modes((c) => ({ background: { color: c.chrome }, borderColor: c.border })),
        logo: { enabled: false, location: 'START' },
      },
      pageHeader: {
        backgroundImage: { enabled: false },
        ...modes((c) => ({ background: { color: c.chrome }, borderColor: c.border })),
        logo: { enabled: false, location: 'START' },
      },
      pageText: modes((c) => ({
        bodyColor: c.foreground,
        descriptionColor: c.mutedForeground,
        headingColor: c.foreground,
      })),
      phoneNumberSelector: { displayType: 'TEXT' },
      primaryButton: modes((c) => ({
        active: { backgroundColor: c.primaryHover, textColor: c.primaryForeground },
        defaults: { backgroundColor: c.primary, textColor: c.primaryForeground },
        disabled: { backgroundColor: c.secondary, borderColor: c.secondary },
        hover: { backgroundColor: c.primaryHover, textColor: c.primaryForeground },
      })),
      secondaryButton: modes((c) => ({
        active: {
          backgroundColor: c.secondaryHover,
          borderColor: c.secondaryHover,
          textColor: c.secondaryForeground,
        },
        defaults: {
          backgroundColor: c.secondary,
          borderColor: c.secondary,
          textColor: c.secondaryForeground,
        },
        hover: {
          backgroundColor: c.secondaryHover,
          borderColor: c.secondaryHover,
          textColor: c.secondaryForeground,
        },
      })),
    },
  };
}

/** The images the style uses: the app icon as the form logo and the favicon, for both colour modes. */
export function loginBrandingAssets(): CfnManagedLoginBranding.AssetTypeProperty[] {
  return [
    {
      category: 'FORM_LOGO',
      colorMode: 'DYNAMIC',
      extension: 'PNG',
      bytes: readFileSync(LOGIN_LOGO_PATH).toString('base64'),
    },
    {
      category: 'FAVICON_ICO',
      colorMode: 'DYNAMIC',
      extension: 'ICO',
      bytes: readFileSync(LOGIN_FAVICON_PATH).toString('base64'),
    },
  ];
}

/**
 * The managed login branding style for an app client. Managed login shows an error page to clients without a
 * style, so every client on the pool needs one.
 */
export function addLoginBranding(
  scope: Construct,
  id: string,
  props: { userPoolId: string; clientId: string },
): CfnManagedLoginBranding {
  return new CfnManagedLoginBranding(scope, id, {
    userPoolId: props.userPoolId,
    clientId: props.clientId,
    settings: loginBrandingSettings(),
    assets: loginBrandingAssets(),
  });
}
