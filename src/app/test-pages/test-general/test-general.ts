import { Component, inject, OnInit } from '@angular/core';
import { OkStatus, ValuesService } from '../../swagger';
import { version, versionDateString } from '../../shared/version';
import { MatButtonModule } from '@angular/material/button';

@Component({
  selector: 'app-test-general',
  imports: [
    MatButtonModule,
  ],
  templateUrl: './test-general.html',
  styleUrl: './test-general.scss'
})
export class TestGeneral implements OnInit {
  private valuesService = inject(ValuesService);
  linqAverage = 0;
  linqAverageExpected = 2.5;
  okStatus: OkStatus = { isOk: false, error: '', nr: -2 };
  versionString = `v${version} [${versionDateString}]`;
  namesActual = '';
  namesExpected = 'Miller Frank, Brown David, Anderson Jack';

  ngOnInit(): void {
    this.linqAverage = [1, 2, 3, 4].average(); //testing linq
    this.valuesService.valuesProductsGet().subscribe(
      {
        next: x => this.okStatus = x,
        error: err => this.okStatus.error = err.message,
      });

    type Person = {
      id: number;
      firstname: string;
      lastname: string;
      age: number;
    };
    const people: Person[] = [
      { id: 1, firstname: "Alice", lastname: "Johnson", age: 28 },
      { id: 2, firstname: "Bob", lastname: "Smith", age: 34 },
      { id: 3, firstname: "Carol", lastname: "Williams", age: 25 },
      { id: 4, firstname: "David", lastname: "Brown", age: 42 },
      { id: 5, firstname: "Emma", lastname: "Davis", age: 30 },
      { id: 6, firstname: "Frank", lastname: "Miller", age: 37 },
      { id: 7, firstname: "Grace", lastname: "Wilson", age: 29 },
      { id: 8, firstname: "Henry", lastname: "Moore", age: 33 },
      { id: 9, firstname: "Ivy", lastname: "Taylor", age: 26 },
      { id: 10, firstname: "Jack", lastname: "Anderson", age: 40 },
    ];

    const names = people
      .where(p => p.age > 35)
      .select(p => `${p.lastname} ${p.firstname}`)
      .distinct()
      .orderDescending();
    this.namesActual = names.join(', ');
  }
}
