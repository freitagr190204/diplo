import { Routes } from '@angular/router';
import {HomeComponent} from './home-component/home-component';

export const routes: Routes = [
  { path: '', pathMatch:'full', redirectTo: 'home' },
  { path: 'home', component: HomeComponent},
  { path: 'test', loadComponent: () => import('./test-pages/test-general/test-general').then(x => x.TestGeneral) },
  { path: '**', redirectTo: 'home' },
];
