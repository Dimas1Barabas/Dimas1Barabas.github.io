import React from 'react';
import Project from '../components/Project/Project';
import projects from '../helpers/projectList.js';

const Projects = () => {
  return (
    <main className="section">
      <div className="container">
        <h2 className="title-1">Projects</h2>
        <ul className="projects">
          {projects.map((item, index)  => {
            return (
              <Project
                key={item.id}
                title={item.title}
                src={item.img}
                index={index}
              />
            )
          })}
        </ul>
      </div>
    </main>
  );
};

export default Projects;