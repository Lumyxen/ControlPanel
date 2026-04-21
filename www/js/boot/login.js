import { mountLoginPage } from '../pages/login/page.js';

export async function bootLogin() {
	await mountLoginPage(document.body);
}
