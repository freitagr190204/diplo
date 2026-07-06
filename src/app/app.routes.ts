import { Routes } from '@angular/router';
import {HomeComponent} from './home-component/home-component';
import {StartComponent} from './start-component/start-component';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'start' },
  { path: 'start', component: StartComponent },
  { path: 'home', component: HomeComponent, data: { fairMode: false } },
  { path: 'messe', component: HomeComponent, data: { fairMode: true } },
  { path: 'test', loadComponent: () => import('./test-pages/test-general/test-general').then(x => x.TestGeneral) },
  { path: '**', redirectTo: 'start' },
];
