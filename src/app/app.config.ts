import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';

import { routes } from './app.routes';
import { version, versionDateString } from './shared/version';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { BASE_PATH } from './swagger';
import { environment } from '../environments/environment';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withFetch()),
    { provide: BASE_PATH, useValue: environment.apiRoot },
  ]
};

console.log(`Based on Angular20 Template v${version} [${versionDateString}]`);
