import { LOGIN_PATH } from '../lib/cognito_oauth';

/** Sign-in choices: Google goes straight to Google; email opens Cognito's page, which also offers sign-up. */
export function SignInButtons() {
  return (
    <div className="sign-in-buttons">
      <a href={`${LOGIN_PATH}?provider=google`} className="button">
        Continue with Google
      </a>
      <a href={LOGIN_PATH} className="button">
        Sign in or sign up with email
      </a>
    </div>
  );
}
